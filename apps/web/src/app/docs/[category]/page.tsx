'use client';

import { use, useState, useEffect } from 'react';
import { FileText } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { ArticleList } from '@/components/docs/article-list';

interface DocArticle {
    id: string;
    title: string;
    content: string;
    status: 'DRAFT' | 'PUBLISHED';
    sourceUrl?: string | null;
    categoryId: string;
    category?: { id: string; name: string; description?: string | null };
    createdAt: string;
    updatedAt: string;
}

interface CategoryPageProps {
    params: Promise<{ category: string }>;
}

export default function CategoryPage({ params }: CategoryPageProps) {
    const { category: categoryId } = use(params);
    const [articles, setArticles] = useState<DocArticle[]>([]);
    const [categoryName, setCategoryName] = useState<string | null>(null);
    const [categoryDescription, setCategoryDescription] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [notFound, setNotFound] = useState(false);

    useEffect(() => {
        async function fetchData() {
            try {
                // Fetch articles for this category
                const artRes = await fetch(`/api/docs/articles?category=${categoryId}&pageSize=100`);
                if (!artRes.ok) {
                    setNotFound(true);
                    return;
                }
                const artData = await artRes.json();
                setArticles(artData.articles);

                // Extract category info from articles if available
                if (artData.articles.length > 0 && artData.articles[0].category) {
                    setCategoryName(artData.articles[0].category.name);
                    setCategoryDescription(artData.articles[0].category.description ?? null);
                } else {
                    // Fetch categories to get name for this ID (e.g. empty category)
                    const catRes = await fetch('/api/docs/categories');
                    if (catRes.ok) {
                        const catData = await catRes.json();
                        const cat = catData.categories.find((c: { id: string; name: string; description: string | null }) => c.id === categoryId);
                        if (cat) {
                            setCategoryName(cat.name);
                            setCategoryDescription(cat.description);
                        } else {
                            setNotFound(true);
                        }
                    }
                }
            } finally {
                setLoading(false);
            }
        }
        fetchData();
    }, [categoryId]);

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <p className="text-muted-foreground">Loading...</p>
            </div>
        );
    }

    if (notFound) {
        return (
            <div className="flex items-center justify-center py-20">
                <p className="text-muted-foreground">Category not found.</p>
            </div>
        );
    }

    return (
        <div>
            <PageHeader
                title={categoryName || 'Category'}
                description={categoryDescription || undefined}
                icon={FileText}
                breadcrumbs={[
                    { label: 'Docs', href: '/docs' },
                    { label: categoryName || 'Category' },
                ]}
            />

            <ArticleList articles={articles} categoryId={categoryId} />
        </div>
    );
}
